'use strict';
// JTCAT chimes (scottg_178 2026-11-24): an optional sound when a station calls
// me, and a different one when transmitting stops by itself (TX watchdog, the
// 30-minute Hunt / Run limit, Run pausing on a worked-out band). Both off by
// default, both in the JTCAT window's Options > Sounds.
//   lib/jtcat-chimes.js  decides (pure): chime or not, and which sound.
//   lib/chime-sounds.js  the one sound engine, shared with "QSO logged chime".
// Sound only: nothing here stops, starts or changes a transmission.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

let C = null;
try { C = require('../lib/jtcat-chimes'); } catch (e) { C = null; }
let S = null;
try { S = require('../lib/chime-sounds'); } catch (e) { S = null; }
function lib() { assert.ok(C, 'lib/jtcat-chimes.js exists'); return C; }
function snd() { assert.ok(S, 'lib/chime-sounds.js exists'); return S; }

const main = readSrc(path.join(ROOT, 'main.js'));
const app = readSrc(path.join(ROOT, 'renderer', 'app.js'));
const indexHtml = readSrc(path.join(ROOT, 'renderer', 'index.html'));
const pop = readSrc(path.join(ROOT, 'renderer', 'jtcat-popout.js'));
const popHtml = readSrc(path.join(ROOT, 'renderer', 'jtcat-popout.html'));
const pre = readSrc(path.join(ROOT, 'preload.js'));
const prePop = readSrc(path.join(ROOT, 'preload-jtcat-popout.js'));
const bridge = readSrc(path.join(ROOT, 'lib', 'remote-bridge.js'));
const doc = readSrc(path.join(ROOT, 'docs', 'JTCAT.md'));

function extract(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i !== -1, name + ' exists');
  let depth = 0;
  for (let j = src.indexOf('{', src.indexOf(')', i)); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error('unbalanced ' + name);
}

const ME = 'K3SBP';
const CALL = 'call-rise';
const STOP = 'stop-fall';
// A decode as main.js hands it on: text plus r.call, the station transmitting.
const d = (text, call) => ({ text, call });
function ask(state, over) {
  return lib().callChime(state, Object.assign({
    setting: CALL, myCall: ME, results: [], qsoCalls: [], period: '12:00:00', now: 1000000, txActive: false,
  }, over));
}

// ---- the sounds ----
test('sounds: each event has its own list, so the two chimes can never be the same sound', () => {
  const { CALL_SOUNDS, STOP_SOUNDS, QSO_SOUNDS } = snd();
  assert.ok(CALL_SOUNDS.length >= 2 && STOP_SOUNDS.length >= 2);
  const ids = (l) => l.map((s) => s.id);
  for (const id of ids(CALL_SOUNDS)) {
    assert.ok(!ids(STOP_SOUNDS).includes(id), id + ' is not a stop sound');
    assert.ok(!ids(QSO_SOUNDS).includes(id), id + ' is not the QSO logged sound');
  }
  for (const id of ids(STOP_SOUNDS)) assert.ok(!ids(QSO_SOUNDS).includes(id), id + ' is not the QSO logged sound');
  for (const s of CALL_SOUNDS.concat(STOP_SOUNDS, QSO_SOUNDS)) {
    assert.ok(s.label && !/[^\x20-\x7e]/.test(s.label), 'plain label: ' + s.id);
    assert.ok(snd().notesOf(s.id).length > 0, s.id + ' has notes');
  }
});

test('sounds: the QSO logged chime keeps its four sounds, note for note', () => {
  const n = snd().notesOf;
  assert.deepStrictEqual(snd().QSO_SOUNDS.map((s) => s.id), ['soft', 'twotone', 'bell', 'morse-r']);
  assert.deepStrictEqual(n('soft'), [[880, 0, 0.35, 0.18]]);
  assert.deepStrictEqual(n('twotone'), [[660, 0, 0.18, 0.18], [990, 0.16, 0.32, 0.18]]);
  assert.deepStrictEqual(n('bell'), [[1320, 0, 0.9, 0.16], [1980, 0, 0.45, 0.05], [2640, 0, 0.25, 0.03]]);
  const u = 0.06;
  assert.deepStrictEqual(n('morse-r'), [[700, 0, u, 0.2], [700, 2 * u, 3 * u, 0.2], [700, 6 * u, u, 0.2]]);
  assert.deepStrictEqual(n('off'), []);
  assert.deepStrictEqual(n('nonsense'), []);
});

test('sounds: no chime is loud or long (peak 0.2 at most, over inside 1.2 s)', () => {
  for (const s of snd().CALL_SOUNDS.concat(snd().STOP_SOUNDS)) {
    for (const [freq, at, dur, peak] of snd().notesOf(s.id)) {
      assert.ok(freq >= 300 && freq <= 2000, s.id + ' a note a small speaker can play');
      assert.ok(peak <= 0.2, s.id + ' peak');
      assert.ok(at + dur <= 1.2, s.id + ' length');
    }
  }
});

test('sounds: play() schedules one oscillator per note into the context it is given', () => {
  const made = [];
  const ctx = {
    currentTime: 5, destination: { name: 'default output' },
    createOscillator() { const o = { frequency: {}, connect(g) { o.to = g; return g; }, start(t) { o.at = t; }, stop() {} }; made.push(o); return o; },
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(dst) { this.to = dst; return dst; } }; },
  };
  assert.strictEqual(snd().play(ctx, 'call-rise'), true);
  assert.strictEqual(made.length, snd().notesOf('call-rise').length);
  assert.strictEqual(made[0].to.to, ctx.destination, 'straight to the context output');
  assert.strictEqual(snd().play(ctx, 'off'), false);
  assert.strictEqual(snd().play(ctx, 'nonsense'), false);
  assert.strictEqual(snd().play(null, 'call-rise'), false);
});

// ---- off by default ----
test('defaults: a missing setting, "off" or an unknown value is silent', () => {
  for (const setting of [undefined, null, '', 'off', 'bell', 'stop-fall', 42]) {
    assert.strictEqual(ask(lib().createState(), { setting, results: [d('K3SBP W1ABC FN42', 'W1ABC')] }), null, String(setting));
  }
  for (const setting of [undefined, null, '', 'off', 'bell', 'call-rise', 42]) {
    assert.strictEqual(lib().stopChime(lib().createState(), { setting, reason: 'tx-watchdog', now: 1 }), null, String(setting));
  }
});

// ---- a station calls me ----
test('trigger: a station calls me out of the blue', () => {
  assert.strictEqual(ask(lib().createState(), { results: [d('CQ W9XYZ EN52', 'W9XYZ'), d('K3SBP W1ABC FN42', 'W1ABC')] }), CALL);
});

test('trigger: an answer to my CQ (the QSO is still "cq", with nobody in it)', () => {
  assert.strictEqual(ask(lib().createState(), { results: [d('K3SBP W1ABC -07', 'W1ABC')], qsoCalls: [] }), CALL);
});

test('trigger: a second station calls while I am working someone else', () => {
  assert.strictEqual(ask(lib().createState(), {
    results: [d('K3SBP W1ABC R-10', 'W1ABC'), d('K3SBP N0NEW EN34', 'N0NEW')], qsoCalls: ['W1ABC'],
  }), CALL);
});

test('trigger: my compound call and a hashed call still count as me', () => {
  assert.strictEqual(ask(lib().createState(), { myCall: 'K3SBP/P', results: [d('<K3SBP/P> W1ABC -10', 'W1ABC')] }), CALL);
});

test('not a trigger: a CQ, or two other stations talking', () => {
  assert.strictEqual(ask(lib().createState(), { results: [d('CQ W9XYZ EN52', 'W9XYZ'), d('N5AAA W1ABC -10', 'W1ABC')] }), null);
});

test('not a trigger: my own transmission or my own echo', () => {
  const st = lib().createState();
  assert.strictEqual(ask(st, { results: [d('W1ABC K3SBP -10', 'K3SBP'), d('CQ K3SBP FN20', 'K3SBP')] }), null);
  assert.strictEqual(ask(st, { myCall: 'K3SBP/P', period: '12:00:15', results: [d('W1ABC <K3SBP/P> R-10', 'K3SBP/P')] }), null);
});

test('not a trigger: a decode with no transmitter, or no callsign of my own set', () => {
  assert.strictEqual(ask(lib().createState(), { results: [d('K3SBP W1ABC FN42', '')] }), null);
  assert.strictEqual(ask(lib().createState(), { myCall: '', results: [d('K3SBP W1ABC FN42', 'W1ABC')] }), null);
});

test('not a trigger: the station I am already working (every leg of that QSO)', () => {
  const st = lib().createState();
  let t = 1000000;
  for (const [period, text] of [['12:00:00', 'K3SBP W1ABC -07'], ['12:00:30', 'K3SBP W1ABC R-07'], ['12:01:00', 'K3SBP W1ABC RR73']]) {
    assert.strictEqual(ask(st, { period, now: (t += 30000), results: [d(text, 'W1ABC')], qsoCalls: ['W1ABC/P'] }), null, text);
  }
});

test('not a trigger: their last 73 after the QSO is over and cleared', () => {
  const st = lib().createState();
  ask(st, { period: '12:00:00', now: 1000000, results: [d('K3SBP W1ABC R-07', 'W1ABC')], qsoCalls: ['W1ABC'] });
  assert.strictEqual(ask(st, { period: '12:00:30', now: 1030000, results: [d('K3SBP W1ABC 73', 'W1ABC')], qsoCalls: [] }), null);
});

test('not a trigger: while transmitting; the caller chimes on the next period heard instead', () => {
  const st = lib().createState();
  assert.strictEqual(ask(st, { txActive: true, results: [d('K3SBP W1ABC FN42', 'W1ABC')] }), null);
  assert.strictEqual(ask(st, { period: '12:00:30', now: 1030000, results: [d('K3SBP W1ABC FN42', 'W1ABC')] }), CALL);
});

// ---- the rate limit ----
test('rate limit: one chime per decode period, however many call', () => {
  const st = lib().createState();
  const three = [d('K3SBP W1ABC FN42', 'W1ABC'), d('K3SBP N0NEW EN34', 'N0NEW'), d('K3SBP VE3XYZ FN03', 'VE3XYZ')];
  assert.strictEqual(ask(st, { results: three }), CALL);
  // A second decode pass, or another slice, reporting the same period.
  assert.strictEqual(ask(st, { results: [d('K3SBP KD9LATE EN61', 'KD9LATE')] }), null);
});

test('rate limit: no repeat for a caller who keeps calling', () => {
  const st = lib().createState();
  assert.strictEqual(ask(st, { results: [d('K3SBP W1ABC FN42', 'W1ABC')] }), CALL);
  let t = 1000000;
  for (const period of ['12:00:30', '12:01:00', '12:01:30', '12:02:00']) {
    assert.strictEqual(ask(st, { period, now: (t += 30000), results: [d('K3SBP W1ABC FN42', 'W1ABC')] }), null, period);
  }
});

test('rate limit: everyone in the period that chimed is counted as heard', () => {
  const st = lib().createState();
  ask(st, { results: [d('K3SBP W1ABC FN42', 'W1ABC'), d('K3SBP N0NEW EN34', 'N0NEW')] });
  assert.strictEqual(ask(st, { period: '12:00:30', now: 1030000, results: [d('K3SBP N0NEW EN34', 'N0NEW')] }), null);
});

test('rate limit: a caller who went quiet and comes back later is a new call', () => {
  const st = lib().createState();
  assert.strictEqual(ask(st, { results: [d('K3SBP W1ABC FN42', 'W1ABC')] }), CALL);
  const later = 1000000 + lib().CALLER_QUIET_MS + 1000;
  assert.strictEqual(ask(st, { period: '12:20:00', now: later, results: [d('K3SBP W1ABC FN42', 'W1ABC')] }), CALL);
});

test('rate limit: callers are remembered while the chime is off, so turning it on mid-QSO is quiet', () => {
  const st = lib().createState();
  ask(st, { setting: 'off', results: [d('K3SBP W1ABC FN42', 'W1ABC')] });
  assert.strictEqual(ask(st, { period: '12:00:30', now: 1030000, results: [d('K3SBP W1ABC FN42', 'W1ABC')] }), null);
});

test('rate limit: the caller memory does not grow without end', () => {
  const st = lib().createState();
  let t = 1000000;
  for (let i = 0; i < 500; i++) {
    ask(st, { period: 'p' + i, now: (t += 15000), results: [d('K3SBP W' + (i % 10) + 'A' + i + ' FN42', 'W' + (i % 10) + 'A' + i)] });
  }
  assert.ok(st.callers.size <= lib().CALLER_QUIET_MS / 15000 + 2, 'old callers are dropped: ' + st.callers.size);
});

// ---- transmitting stops by itself ----
test('trigger: each automatic stop chimes', () => {
  assert.deepStrictEqual(lib().AUTO_STOP_REASONS.slice().sort(), ['hunt-idle', 'run-idle', 'run-paused', 'tx-watchdog']);
  for (const reason of lib().AUTO_STOP_REASONS) {
    assert.strictEqual(lib().stopChime(lib().createState(), { setting: STOP, reason, now: 1 }), STOP, reason);
  }
});

test('not a trigger: the operator stopped it, or any reason not on the list', () => {
  for (const reason of ['operator', 'Halt TX (JTCAT window)', 'stopped by operator', 'Hunt changed by operator', 'stopped from phone', 'mode change', '', undefined]) {
    assert.strictEqual(lib().stopChime(lib().createState(), { setting: STOP, reason, now: 1 }), null, String(reason));
  }
});

test('rate limit: Run and Hunt ending together at the 30-minute limit is one chime', () => {
  const st = lib().createState();
  assert.strictEqual(lib().stopChime(st, { setting: STOP, reason: 'run-idle', now: 5000 }), STOP);
  assert.strictEqual(lib().stopChime(st, { setting: STOP, reason: 'hunt-idle', now: 5001 }), null);
  assert.strictEqual(lib().stopChime(st, { setting: STOP, reason: 'tx-watchdog', now: 5001 + lib().STOP_REPEAT_MS }), STOP);
});

test('the two chimes are told apart: a calling sound is refused as a stop sound and the other way round', () => {
  assert.strictEqual(lib().callSound('stop-fall'), null);
  assert.strictEqual(lib().stopSound('call-rise'), null);
  assert.strictEqual(lib().callSound('call-rise'), 'call-rise');
  assert.strictEqual(lib().stopSound('stop-fall'), 'stop-fall');
  assert.strictEqual(lib().isChimeSound('soft'), false, 'the QSO sounds are not JTCAT chimes');
  assert.strictEqual(lib().isChimeSound('call-rise') && lib().isChimeSound('stop-fall'), true);
});

// ---- glue: main.js ----
test('main: both decode paths ask once per decode event, before the QSO machines move on', () => {
  const calls = main.match(/\bjtcatChimeCallers\(data\);/g) || [];
  assert.strictEqual(calls.length, 2, 'single-engine and multi-slice');
  const fn = extract(main, 'jtcatChimeCallers');
  assert.ok(/JtcatChimes\.callChime\(/.test(fn));
  assert.ok(/settings\.jtcatChimeCall/.test(fn));
  assert.ok(/txActive: jtcatAnyTxActive\(\)/.test(fn), 'silent while transmitting');
  assert.ok(/onAirCall\(\)/.test(fn), 'the authoritative callsign');
  assert.ok(/jtcatQsoOwners\(\)/.test(fn), 'both QSO owners (window and phone)');
  let at = 0;
  for (let i = 0; i < 2; i++) {
    at = main.indexOf('jtcatChimeCallers(data);', at + 1);
    const next = main.slice(at, at + 9000);
    assert.ok(/processPopoutJtcatQso\(/.test(next), 'asked before processPopoutJtcatQso');
  }
});

test('main: only the four automatic stops chime; no operator path does', () => {
  const sites = main.match(/jtcatChimeTxStopped\('[a-z-]+'\)/g) || [];
  assert.deepStrictEqual(sites.slice().sort(), [
    "jtcatChimeTxStopped('hunt-idle')", "jtcatChimeTxStopped('run-idle')",
    "jtcatChimeTxStopped('run-paused')", "jtcatChimeTxStopped('tx-watchdog')",
  ]);
  assert.strictEqual((main.match(/jtcatChimeTxStopped\(/g) || []).length, 5, 'four calls and the definition');
  assert.ok(/jtcatChimeTxStopped\('tx-watchdog'\)/.test(extract(main, 'jtcatTxWatchdogStop')));
  const wd = extract(main, 'jtcatFullAutoCqWatchdog');
  assert.ok(/jtcatChimeTxStopped\('run-idle'\)/.test(wd) && /jtcatChimeTxStopped\('hunt-idle'\)/.test(wd));
  assert.ok(/jtcatChimeTxStopped\('run-paused'\)/.test(extract(main, 'jtcatPauseRunCq')));
  for (const name of ['jtcatHaltTxNow', 'stopFullAutoCq', 'setJtcatHuntMode']) {
    assert.ok(!/jtcatChime/.test(extract(main, name)), name + ' is shared with the operator and stays silent');
  }
});

test('main: the stop chime waits for the key-up and is dropped if TX is on again', () => {
  const fn = extract(main, 'jtcatChimeTxStopped');
  assert.ok(/JtcatChimes\.stopChime\(/.test(fn) && /settings\.jtcatChimeStop/.test(fn));
  assert.ok(/setTimeout\(/.test(fn) && /JtcatChimes\.STOP_DELAY_MS/.test(fn));
  assert.ok(lib().STOP_DELAY_MS >= 500);
});

test('main: a chime is one message to the main window and nothing else', () => {
  const fn = extract(main, 'jtcatSendChime');
  assert.ok(/jtcatAnyTxActive\(\)/.test(fn), 'never started while JTCAT is transmitting');
  assert.ok(/win\.webContents\.send\('jtcat-chime', \{ sound \}\)/.test(fn));
  // Sound only: no chime function touches TX, PTT, the engine or a setting.
  for (const name of ['jtcatSendChime', 'jtcatChimeCallers', 'jtcatChimeTxStopped']) {
    const body = extract(main, name);
    assert.ok(!/_txEnabled|setTxMessage|jtcatHaltTxNow|stopFullAutoCq|setJtcatHuntMode|handleRemotePtt|gatedSetTransmit|requestTx|saveSettings|settings\.\w+\s*=[^=]/.test(body), name + ' changes nothing');
  }
});

test('main: the Test button plays only a known JTCAT chime', () => {
  const i = main.indexOf("ipcMain.on('jtcat-chime-test'");
  assert.ok(i !== -1);
  const h = main.slice(i, i + 300);
  assert.ok(/JtcatChimes\.isChimeSound\(/.test(h) && /jtcatSendChime\(/.test(h));
});

test('main: both settings belong to this computer', () => {
  const g = main.slice(main.indexOf('const GLOBAL_KEYS'), main.indexOf('const GLOBAL_KEYS') + 7000);
  assert.ok(/'jtcatChimeCall',/.test(g) && /'jtcatChimeStop',/.test(g));
});

// ---- glue: the main window plays it ----
test('main window: one sound engine, on the default output, never the transmit device', () => {
  assert.ok(/<script src="\.\.\/lib\/chime-sounds\.js"><\/script>/.test(indexHtml), 'index.html loads the shared sounds');
  const fn = extract(app, 'playQsoChime');
  // #1041: every operator sound goes through PotacatSounds (renderer/sounds.js), whose transmit
  // guard picks the output (never the radio's sound card) and holds it while transmitting.
  assert.ok(/PotacatSounds\.playChime\(/.test(fn) && /ChimeSounds\.play\(ctx, id, out\)/.test(fn), 'the QSO chime plays through the shared engine, into the guarded output');
  assert.ok(!/createOscillator/.test(fn), 'and no longer builds its own tones');
  assert.ok(!/setSinkId|remoteAudioOutput|jtcatTxAudioCtx/.test(fn), 'no chosen device: the system default output');
  assert.ok(/window\.api\.onJtcatChime\(/.test(app));
  const i = app.indexOf('window.api.onJtcatChime(');
  assert.ok(/PotacatSounds\.playChime\(\(ctx, out\) => \{ ChimeSounds\.play\(ctx, id, out\)/.test(app.slice(i, i + 700)), 'the JTCAT chimes use the same guarded engine');
  assert.ok(/onJtcatChime: \(cb\) => ipcRenderer\.on\('jtcat-chime'/.test(pre), 'preload');
  // The chime context is created with no options and never given a sink.
  assert.ok(!/\baudioCtx\.setSinkId/.test(app), 'the chime context is never routed to a device');
  const lib = readSrc(path.join(ROOT, 'lib', 'chime-sounds.js'));
  assert.ok(!/setSinkId|new Audio\(|getUserMedia/.test(lib), 'synthesized, no audio asset, no device');
});

// ---- glue: the JTCAT window's Options ----
test('options: a Sounds section with both controls, Off first, a Test button each', () => {
  const i = popHtml.indexOf('<div class="jp-opt-section">Sounds</div>');
  assert.ok(i !== -1, 'Options > Sounds');
  const sec = popHtml.slice(i, popHtml.indexOf('<div class="jp-opt-section">', i + 10));
  assert.ok(/Chime when a station calls me <select id="jp-chime-call">/.test(sec));
  assert.ok(/Chime when transmitting stops by itself <select id="jp-chime-stop">/.test(sec));
  assert.ok(/id="jp-chime-call-test"[^>]*>Test<\/button>/.test(sec) && /id="jp-chime-stop-test"[^>]*>Test<\/button>/.test(sec));
  assert.strictEqual((sec.match(/<option value="off" selected>Off<\/option>/g) || []).length, 2, 'Off is first and selected in both');
  assert.ok(!/[^\x00-\x7e]/.test(sec.replace(/&\w+;/g, '')), 'plain text, no emoji');
  assert.ok(/<script src="\.\.\/lib\/chime-sounds\.js"><\/script>/.test(popHtml));
});

test('options: saved as jtcatChimeCall / jtcatChimeStop, read back at start, Test goes to the main window', () => {
  assert.ok(/saveSettings\(\{ jtcatChimeCall: /.test(pop) && /saveSettings\(\{ jtcatChimeStop: /.test(pop));
  assert.ok(/s\.jtcatChimeCall/.test(pop) && /s\.jtcatChimeStop/.test(pop), 'read at start');
  assert.ok(/ChimeSounds\.CALL_SOUNDS/.test(pop) && /ChimeSounds\.STOP_SOUNDS/.test(pop), 'the lists come from the shared module');
  assert.ok(/window\.api\.jtcatChimeTest\(/.test(pop));
  assert.ok(/jtcatChimeTest: \(sound\) => ipcRenderer\.send\('jtcat-chime-test', sound\)/.test(prePop));
  assert.ok(/'jtcat-chime-test': /.test(bridge), 'declared local in lib/remote-bridge.js');
  assert.ok(!/AudioContext/.test(pop.slice(pop.indexOf('jp-chime-call'), pop.indexOf('jp-chime-call') + 2500)), 'the window itself makes no sound');
});

test('docs: JTCAT.md names the settings and the rule', () => {
  assert.ok(/jtcatChimeCall/.test(doc) && /jtcatChimeStop/.test(doc));
  assert.ok(/lib\/jtcat-chimes\.js/.test(doc));
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }
