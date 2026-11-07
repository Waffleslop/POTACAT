#!/usr/bin/env node
'use strict';
// GitHub #190 (FT-891 on Ubuntu, JS8). Every tx-start refusal in main.js
// ("TX blocked — the radio is on 7.078 MHz but JTCAT is set to 14.078 MHz")
// unwound the engine with txComplete(), and Js8Engine.txComplete() on an
// empty queue announces js8-tx-done — so the CAT log said "[JS8] message
// fully transmitted: HB EM00" one millisecond after refusing to key. Three
// times in one session.
//
// A refusal is now txRefused(reason) on the engine:
//   - Js8Engine: the TX state is cleared like a completion, the rest of the
//     message is dropped, TX disarmed, ONE js8-tx-refused event, never a
//     js8-tx-done.
//   - Ft8Engine / PskEngine / JttyEngine: txRefused IS txComplete. The FT8
//     path is the most-used one and must stay byte-for-byte what it was: the
//     test below records the events master's refusal produced and holds the
//     new call to the same list.
// The same report had two more surfaces: the mode-silence note fired on a
// radio that had never answered at all (rig-test.js), and ECHOCAT Web hid
// HALT (E-STOP) because the mode was not a voice mode — a safety stop is
// never gated on the mode.
// Run: node test/jtcat-tx-refused-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { Ft8Engine } = require('../lib/ft8-engine');
const { Js8Engine } = require('../lib/js8-engine');
const { PskEngine } = require('../lib/psk-engine');
const { JttyEngine } = require('../lib/jtty-engine');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const ROOT = path.join(__dirname, '..');
const MAIN = readSrc(path.join(ROOT, 'main.js'));
const REMOTE = readSrc(path.join(ROOT, 'renderer', 'remote.js'));
const REMOTE_HTML = readSrc(path.join(ROOT, 'renderer', 'remote.html'));
const MANAGER = readSrc(path.join(ROOT, 'lib', 'jtcat-manager.js'));

/** Record every event an engine emits: [name, payload]. */
function recordEvents(eng) {
  const events = [];
  const emit = eng.emit.bind(eng);
  eng.emit = (name, ...args) => { events.push([name, ...args]); return emit(name, ...args); };
  return events;
}

/** The engine as main.js sees it the instant a tx-start handler runs: the
 *  frame is "on the air" and the safety timer is armed. */
function armed(eng) {
  eng._txActive = true;
  eng._txEndTimer = setTimeout(() => {}, 60000);
  return eng;
}

// What master's refusal sites did, verbatim:
//   try { if (ft8Engine && ft8Engine._txActive) ft8Engine.txComplete(); } catch {}
function masterRefusal(ft8Engine) {
  try { if (ft8Engine && ft8Engine._txActive) ft8Engine.txComplete(); } catch {}
}
// Recorded from master (c3526bbf): an armed Ft8Engine refusal emits exactly
// one event, 'tx-end' with an empty payload, and nothing else.
const MASTER_FT8_REFUSAL_EVENTS = [['tx-end', {}]];

function stateOf(eng) {
  return {
    txActive: eng._txActive,
    timerCleared: eng._txEndTimer === null,
    txEnabled: eng._txEnabled,
    txMessage: eng._txMessage,
    ended: typeof eng._lastTxEndedTs === 'number' && eng._lastTxEndedTs > 0,
  };
}

for (const mode of ['FT8', 'FT4', 'FT2']) {
  test(`${mode}: a refusal produces exactly the events it produced on master (tx-end, nothing else)`, () => {
    const a = armed(new Ft8Engine()); a._mode = mode; a._txEnabled = true; a._txMessage = 'CQ POTA K3SBP FN20';
    const b = armed(new Ft8Engine()); b._mode = mode; b._txEnabled = true; b._txMessage = 'CQ POTA K3SBP FN20';
    const before = recordEvents(a);
    const after = recordEvents(b);
    masterRefusal(a);
    assert.strictEqual(typeof b.txRefused, 'function', 'Ft8Engine.txRefused missing');
    b.txRefused('the radio is on 7.078 MHz (40m), JTCAT on 14.078 MHz (20m)');
    assert.deepStrictEqual(before, MASTER_FT8_REFUSAL_EVENTS, 'master recording drifted: ' + JSON.stringify(before));
    assert.deepStrictEqual(after, before, 'new refusal events differ from master: ' + JSON.stringify(after));
    assert.deepStrictEqual(stateOf(b), stateOf(a));
    assert.deepStrictEqual(stateOf(a), { txActive: false, timerCleared: true, txEnabled: true, txMessage: 'CQ POTA K3SBP FN20', ended: true });
  });
}

test('FT8: a refusal with nothing on the air is a no-op, as on master', () => {
  const a = new Ft8Engine(); const b = new Ft8Engine();
  const before = recordEvents(a); const after = recordEvents(b);
  masterRefusal(a);
  b.txRefused('SWR guard tripped');
  assert.deepStrictEqual(before, []);
  assert.deepStrictEqual(after, []);
});

test('PSK31 and JTTY: txRefused is txComplete (same events as master)', () => {
  for (const make of [() => new PskEngine(), () => new JttyEngine({ worker: false })]) {
    const a = armed(make()); const b = armed(make());
    const before = recordEvents(a); const after = recordEvents(b);
    masterRefusal(a);
    assert.strictEqual(typeof b.txRefused, 'function', 'txRefused missing on ' + b._mode);
    b.txRefused('Mercury (HF data) owns the radio');
    assert.deepStrictEqual(before, [['tx-end', {}]], b._mode);
    assert.deepStrictEqual(after, before, b._mode);
    assert.strictEqual(b._txActive, false);
    assert.strictEqual(b._txEndTimer, null);
  }
});

// ── JS8 ───────────────────────────────────────────────────────────────────────
// No worker: setTxText packs frames in pure JS; the slot tick is replayed by
// hand (shift the frame, mark it active, arm the safety timer) exactly as
// _slotTick does before it emits tx-start.
function js8OnAir(text) {
  const eng = new Js8Engine();
  eng.setStation({ call: 'KI7LIK', grid: 'EM00' });
  const frames = eng.setTxText(text);
  assert.ok(frames >= 1, 'message must pack: ' + text);
  eng._txEnabled = true;
  eng._txQueue.shift();
  armed(eng);
  return { eng, frames };
}

test('JS8: a refused heartbeat is NOT "fully transmitted" — one js8-tx-refused, no js8-tx-done', () => {
  const { eng } = js8OnAir('HB EM00');
  const events = recordEvents(eng);
  assert.strictEqual(typeof eng.txRefused, 'function', 'Js8Engine.txRefused missing');
  eng.txRefused('the radio is on 7.078 MHz (40m), JTCAT on 14.078 MHz (20m)');
  const names = events.map((e) => e[0]);
  assert.ok(!names.includes('js8-tx-done'), 'a refusal must never announce a completion: ' + names.join(','));
  assert.deepStrictEqual(names.filter((n) => n === 'tx-end'), ['tx-end'], 'tx-end exactly once (main releases PTT and the radio on it)');
  const refused = events.filter((e) => e[0] === 'js8-tx-refused');
  assert.strictEqual(refused.length, 1, 'exactly one js8-tx-refused');
  assert.strictEqual(refused[0][1].message, 'HB EM00');
  assert.strictEqual(refused[0][1].reason, 'the radio is on 7.078 MHz (40m), JTCAT on 14.078 MHz (20m)');
  assert.ok(names.indexOf('tx-end') < names.indexOf('js8-tx-refused'), 'PTT release first, then the verdict');
  // Cleared like a completion, and disarmed: the next slot must not key.
  assert.strictEqual(eng._txActive, false);
  assert.strictEqual(eng._txEndTimer, null);
  assert.strictEqual(eng._txEnabled, false);
  assert.strictEqual(eng.txQueueLength, 0);
  assert.strictEqual(eng._txTotal, 0);
  assert.strictEqual(eng._txMessage, '');
  assert.strictEqual(eng._txQueueMessage, '');
});

test('JS8: a refusal mid-message drops the rest of the queue and says how many frames', () => {
  const { eng, frames } = js8OnAir('KN4CRD MSG HELLO FROM POTACAT THIS IS A LONGER MESSAGE');
  assert.ok(frames >= 2, 'needs a multi-frame message, got ' + frames);
  const events = recordEvents(eng);
  eng.txRefused('SWR guard tripped');
  const refused = events.filter((e) => e[0] === 'js8-tx-refused');
  assert.strictEqual(refused.length, 1);
  assert.strictEqual(refused[0][1].framesDropped, frames - 1, 'the frames that were still queued');
  assert.strictEqual(eng.txQueueLength, 0, 'a message whose first frame never went out is not continued from frame 2');
  assert.ok(!events.some((e) => e[0] === 'js8-tx-done'));
});

test('JS8: a refusal with nothing on the air and nothing queued emits nothing', () => {
  const eng = new Js8Engine();
  const events = recordEvents(eng);
  eng.txRefused('nothing');
  assert.deepStrictEqual(events, []);
});

test('JS8: a real completion still announces js8-tx-done (unchanged)', () => {
  const { eng } = js8OnAir('HB EM00');
  const events = recordEvents(eng);
  eng.txComplete();
  assert.deepStrictEqual(events.map((e) => e[0]), ['tx-end', 'js8-tx-done']);
  assert.strictEqual(events[1][1].message, 'HB EM00');
});

test('jtcat-manager forwards js8-tx-refused like js8-tx-done', () => {
  assert.ok(/'js8-tx-done',\s*'js8-tx-refused'/.test(MANAGER), 'js8-tx-refused is not in the forwarded event list');
});

// ── main.js wiring ────────────────────────────────────────────────────────────
test('main.js: jtcatRefuseTx(reason) exists and calls the engine\'s txRefused', () => {
  const at = MAIN.indexOf('function jtcatRefuseTx(');
  assert.ok(at > 0, 'jtcatRefuseTx missing');
  const body = MAIN.slice(at, MAIN.indexOf('\n}', at));
  assert.ok(/ft8Engine\.txRefused\(reason\)/.test(body), 'must call txRefused(reason)');
});

test('main.js: every tx-start guard before the key-down refuses through jtcatRefuseTx, none through txComplete', () => {
  const start = MAIN.indexOf("ft8Engine.on('tx-start', (data) => {\n    // Radio-owner arbiter");
  assert.ok(start > 0, 'single-band tx-start handler');
  const body = MAIN.slice(start, MAIN.indexOf("ft8Engine.on('tx-end'", start));
  const key = body.indexOf("handleRemotePtt(true, { audio: true, emission: 'DATA'");
  assert.ok(key > 0, 'key-down not found');
  const guards = body.slice(0, key);
  assert.strictEqual((guards.match(/txComplete\(\)/g) || []).length, 0, 'a refusal before the key-down must not look like a completion');
  const refusals = (guards.match(/jtcatRefuseTx\(/g) || []).length;
  assert.ok(refusals >= 7, 'expected the seven pre-key refusal sites, found ' + refusals);
  for (const site of ["radioOwner === 'mercury'", '_swrTripped', "broadcastJtcatQsoState({ phase: 'error', error: dialMsg })", "ownTxPrivilegeRefused('DATA')", 'jtcatTxWatchdogTripped(', 'RS-BA1 TX audio is not ready', '!fakeItShiftForTx(data)']) {
    const i = guards.indexOf(site);
    assert.ok(i > 0, 'site missing: ' + site);
    assert.ok(guards.slice(i, i + 900).includes('jtcatRefuseTx('), 'site does not refuse through jtcatRefuseTx: ' + site);
  }
  // After the key-down: the silent-waveform abort is a refusal too; the
  // completions after the audio was queued to the radio stay txComplete().
  const after = body.slice(key);
  const silent = after.indexOf('txAudio.outputPeak < 0.01');
  assert.ok(silent > 0 && after.slice(silent, silent + 400).includes('jtcatRefuseTx('), 'silent-waveform abort must refuse');
  assert.ok((after.match(/ft8Engine\.txComplete\(\)/g) || []).length >= 3, 'the real completions after the audio went out must stay');
});

test('main.js: the refusal is logged as NOT transmitted, with the reason, and never as fully transmitted', () => {
  assert.ok(MAIN.includes("ft8Engine.removeAllListeners('js8-tx-refused');"), 'stale listeners from the previous startJtcat must go');
  const at = MAIN.indexOf("ft8Engine.on('js8-tx-refused'");
  assert.ok(at > 0, 'no js8-tx-refused listener');
  const body = MAIN.slice(at, at + 1200);
  assert.ok(/NOT transmitted: \$\{message\} \(blocked: \$\{reason\}\)/.test(body), 'log line must name the message and the reason');
  assert.ok(!body.includes('fully transmitted'), 'a refusal never says fully transmitted');
  assert.ok(body.includes('js8PushStatus()'), 'every JS8 surface learns the TX state changed');
  assert.ok(/heartbeat/.test(body), 'a dropped heartbeat is called a heartbeat');
});

// ── ECHOCAT Web: HALT (E-STOP) is never hidden by the mode ───────────────────
test('ECHOCAT Web: HALT (E-STOP) stays visible in CW/RTTY/unknown mode; PTT is still mode-gated', () => {
  assert.ok(REMOTE.includes("pttBtn.classList.toggle('hidden', !isVoice);"), 'PTT keeps its voice-mode gate');
  assert.ok(!/estopBtn\.classList\.toggle\('hidden'/.test(REMOTE), 'E-STOP must never be hidden by the mode');
  assert.ok(!/estopBtn\.classList\.add\('hidden'/.test(REMOTE), 'E-STOP must never be hidden');
  const btn = REMOTE_HTML.match(/<button id="estop-btn"[^>]*>/);
  assert.ok(btn, 'estop-btn markup');
  assert.ok(!/\bhidden\b/.test(btn[0]), 'E-STOP starts visible');
});

// ── Reconnects and the link wording (same report) ────────────────────────────
test('main.js: a reconnect through connectCatSafe logs its reason', () => {
  const at = MAIN.indexOf('function connectCatSafe(context) {');
  assert.ok(at > 0);
  const body = MAIN.slice(at, MAIN.indexOf('\n}', at));
  assert.ok(/sendCatLog\(`\[CAT\] \$\{cat \? 'Reconnecting' : 'Connecting'\} \(\$\{context\}\)`\);/.test(body), 'the reason is logged before the connect');
});

test('main.js: a reopened port is not "Radio link restored" until the radio has answered', () => {
  const at = MAIN.indexOf("sendCatLog('[CAT] Radio link restored.');");
  assert.ok(at > 0, 'the restored line stays (yaesu-scope-test pins it)');
  const around = MAIN.slice(at - 600, at + 300);
  assert.ok(/radioPowerEvidence\(\) === true/.test(around), 'answered = a reply within the poll window');
  assert.ok(/Port reopened/.test(around), 'the no-answer wording');
});

console.log(`\nJTCAT TX refused (#190): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
